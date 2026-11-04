using System;
using System.Collections.Generic;
using System.Linq;

namespace Demo
{
    public record Person(string Name, int Age);

    public static class Program
    {
        public static void Main(string[] args)
        {
            var people = new List<Person>
            {
                new("Ada", 36),
                new("Linus", 28),
                new("Grace", 45),
            };

            foreach (var p in people.Where(p => p.Age > 30).OrderBy(p => p.Name))
            {
                Console.WriteLine($"{p.Name} is {p.Age}");
            }
        }
    }
}
